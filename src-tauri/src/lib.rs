mod ai;
mod audio;
mod calendar;
mod commands;
pub mod db; // pub: the perchnote-mcp bin (src/bin/) reuses the query layer read-only
mod deeplink;
mod secrets;
mod state;
mod transcription;

use db::Database;
use state::AppState;
use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

/// Install a panic hook that records the panic site, message, thread and a
/// backtrace before the default hook runs.
///
/// A panic inside a synchronous Tauri command or a custom URI-scheme handler
/// (asset:/ipc:) unwinds across wry's `extern "C"` boundary into WebKit, which
/// Rust turns into an immediate `abort()` (SIGABRT) — producing a crash report
/// with no Rust context. Crucially, `PanicHookInfo::location()` is compiled in
/// even for release builds stripped of symbols, so this captures the exact
/// `file:line:col` of the next such crash. Logs go to stderr, the `log` facade,
/// and `~/Library/Logs/Perchnote/panic.log` for post-mortem inspection.
fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());

        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());

        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();

        let backtrace = std::backtrace::Backtrace::force_capture();
        let entry = format!(
            "[PANIC] thread '{thread}' panicked at {location}: {message}\n{backtrace}"
        );

        log::error!("{entry}");
        eprintln!("{entry}");

        if let Ok(home) = std::env::var("HOME") {
            let dir = std::path::Path::new(&home).join("Library/Logs/Perchnote");
            if std::fs::create_dir_all(&dir).is_ok() {
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("panic.log"))
                {
                    use std::io::Write;
                    let ts = chrono::Utc::now().to_rfc3339();
                    let _ = writeln!(f, "=== {ts} ===\n{entry}\n");
                }
            }
        }

        default_hook(info);
    }));
}

/// Rebuild the tray menu so it lists the 3 most recent meetings (plan v11
/// #3). Called at startup (first interval tick) and every minute after —
/// title renames, new meetings, and completions all converge within a
/// tick. The on_menu_event handler registered at tray build fires for any
/// menu attached to the tray, so dynamic `open_meeting:<id>` items work
/// without re-registering.
pub(crate) fn rebuild_tray_menu(app: &tauri::AppHandle) {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    let Some(tray) = app.tray_by_id("main-tray") else { return };
    let recents: Vec<(String, String)> = {
        let db = app.state::<db::Database>();
        db.list_meetings()
            .map(|mut ms| {
                // list_meetings orders pinned-first (the meeting list's
                // contract) — "recent" here means what actually happened
                // last (QA audit P2): most recent actual start, falling
                // back to creation; scheduled-future meetings don't count
                // as recent.
                ms.sort_by(|a, b| {
                    let key = |m: &db::queries::Meeting| {
                        m.actual_start.clone().unwrap_or_else(|| m.created_at.clone())
                    };
                    key(b).cmp(&key(a))
                });
                ms.into_iter().take(3).map(|m| (m.id, m.title)).collect()
            })
            .unwrap_or_default()
    };
    let result = (|| -> tauri::Result<()> {
        let new_meeting = MenuItemBuilder::with_id("new_meeting", "New Meeting")
            .accelerator("CmdOrCtrl+N")
            .build(app)?;
        let quick_note = MenuItemBuilder::with_id("quick_note", "Quick Voice Note").build(app)?;
        let toggle_recording =
            MenuItemBuilder::with_id("toggle_recording", "Start/Stop Recording").build(app)?;
        let preferences = MenuItemBuilder::with_id("tray_preferences", "Preferences…")
            .accelerator("CmdOrCtrl+,")
            .build(app)?;
        let show_window = MenuItemBuilder::with_id("show_window", "Show Window").build(app)?;
        let quit = MenuItemBuilder::with_id("quit", "Quit Perchnote").build(app)?;
        let mut mb = MenuBuilder::new(app)
            .item(&new_meeting)
            .item(&quick_note)
            .item(&toggle_recording)
            .separator();
        let mut recent_items = Vec::new();
        for (id, title) in &recents {
            // Grapheme-aware truncation: a 40-char cut can split a ZWJ
            // emoji/flag into a broken glyph (whole-app review P3).
            use unicode_segmentation::UnicodeSegmentation;
            let mut label: String = title.graphemes(true).take(40).collect();
            if label.len() < title.len() {
                label.push('…');
            }
            recent_items.push(
                MenuItemBuilder::with_id(format!("open_meeting:{id}"), label).build(app)?,
            );
        }
        for item in &recent_items {
            mb = mb.item(item);
        }
        if !recent_items.is_empty() {
            mb = mb.separator();
        }
        let menu = mb
            .item(&preferences)
            .item(&show_window)
            .separator()
            .item(&quit)
            .build()?;
        tray.set_menu(Some(menu))?;
        Ok(())
    })();
    if let Err(e) = result {
        log::warn!("tray menu rebuild failed: {e}");
    }
}

pub fn run() {
    install_panic_logger();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        // Logger: log:: macros -> stdout + a rotating file in ~/Library/Logs,
        // and the frontend's error/warn JS calls land in the same stream —
        // webview errors were previously invisible.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("perchnote".into()),
                    }),
                ])
                .max_file_size(2_000_000)
                .build(),
        )
        // Window geometry persists across launches; visibility is excluded
        // because the frontend shows the window after first paint (the
        // launch-flash fix) — the plugin must not show it early.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            // A staged .perchnote restore swaps the database in before it is
            // opened; no-op unless the restore marker exists.
            commands::settings::apply_pending_restore(&app_data_dir);

            // A corrupt database used to mean a panic → crash loop with no
            // way out. Move the damaged file aside (preserved for manual
            // recovery / the backups dir) and start fresh — but ONLY for
            // corruption signatures. A migration bug must still fail loudly
            // instead of silently shelving the user's data.
            let database = match Database::new(app_data_dir.clone()) {
                Ok(db) => db,
                Err(e) => {
                    let msg = e.to_string();
                    let corrupt = msg.contains("integrity check failed")
                        || msg.contains("not a database")
                        || msg.contains("malformed");
                    if !corrupt {
                        panic!("failed to initialize database: {}", msg);
                    }
                    log::error!(
                        "database is corrupt ({}); moving it aside and starting fresh. \
                         The damaged file and daily backups are preserved in the app data folder.",
                        msg
                    );
                    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
                    for suffix in ["", "-wal", "-shm"] {
                        let src = app_data_dir.join(format!("perchnote.db{}", suffix));
                        if src.exists() {
                            let _ = std::fs::rename(
                                &src,
                                app_data_dir.join(format!("perchnote.db.corrupt-{}{}", stamp, suffix)),
                            );
                        }
                    }
                    Database::new(app_data_dir.clone())
                        .expect("failed to initialize a fresh database after corruption recovery")
                }
            };

            db::seed::seed_templates(&database)
                .expect("failed to seed templates");

            // Drop any legacy plaintext secrets from earlier versions; the
            // macOS Keychain is now the only place we store credentials.
            secrets::purge_legacy_plaintext_rows(&database);

            // Run data retention policy on startup 
            {
                let days_str = database.get_setting("retention_days")
                    .ok().flatten().unwrap_or_else(|| "0".to_string());
                let days: u32 = days_str.parse().unwrap_or(0);
                if days > 0 {
                    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
                    let cutoff_str = cutoff.to_rfc3339();
                    if let Ok(conn) = database.conn.lock() {
                        match conn.execute(
                            "UPDATE meetings SET is_archived = 1, updated_at = ?1
                             WHERE is_archived = 0 AND deleted_at IS NULL
                             AND COALESCE(scheduled_start, created_at) < ?2",
                            rusqlite::params![chrono::Utc::now().to_rfc3339(), cutoff_str],
                        ) {
                            Ok(count) if count > 0 => {
                                log::info!("Retention policy: archived {} old meetings", count);
                            }
                            Ok(_) => {}
                            Err(e) => log::error!("Retention policy update failed: {}", e),
                        }
                    }
                }
            }

            // Crash recovery: a session that died mid-recording leaves the
            // meeting stuck in 'recording'/'transcribing' and its WAV header
            // unfinalized. Flip the rows back to 'complete' and repair the
            // headers so the audio is playable again.
            {
                let recordings_dir = app
                    .path()
                    .app_data_dir()
                    .map(|d| d.join("recordings"))
                    .ok();
                match database.reconcile_interrupted_meetings() {
                    Ok(ids) if !ids.is_empty() => {
                        log::warn!(
                            "recovered {} meeting(s) left mid-recording by a previous session",
                            ids.len()
                        );
                        if let Some(dir) = &recordings_dir {
                            for id in &ids {
                                let wav = dir.join(format!("{}.wav", id));
                                if wav.exists() {
                                    commands::audio::repair_wav_header(&wav);
                                }
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) => log::error!("crash reconciliation failed: {}", e),
                }

                // Temp-WAV crumbs (audit P3): the Apple-engine paths write
                // perchnote-*.wav into TMPDIR and remove them on completion —
                // a crash mid-decode leaves meeting audio in /tmp forever.
                if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if (name.starts_with("perchnote-accuracy-")
                            || name.starts_with("perchnote-retranscribe-"))
                            && name.ends_with(".wav")
                        {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }

                // Sweep recordings that belong to no meeting row at all
                // (e.g. rows hard-deleted before file cleanup existed).
                // MOVED ASIDE, never deleted (data-lifecycle audit P1): a
                // restored backup's DB legitimately doesn't know about audio
                // recorded after the backup was taken — deleting here
                // permanently destroyed those recordings on the first launch
                // after a restore. recordings/orphaned/ keeps them
                // recoverable; the user can empty it by hand.
                if let (Some(dir), Ok(ids)) = (&recordings_dir, database.all_meeting_ids()) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        let orphan_dir = dir.join("orphaned");
                        let mut moved = 0u32;
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.extension().and_then(|e| e.to_str()) != Some("wav") {
                                continue;
                            }
                            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                                continue;
                            };
                            if !ids.contains(stem) {
                                if std::fs::create_dir_all(&orphan_dir).is_ok()
                                    && std::fs::rename(&path, orphan_dir.join(format!("{stem}.wav")))
                                        .is_ok()
                                {
                                    moved += 1;
                                }
                            }
                        }
                        if moved > 0 {
                            log::info!(
                                "moved {} orphaned recording(s) to recordings/orphaned/ — \
                                 kept on disk in case they belong to a newer timeline than the database",
                                moved
                            );
                        }
                    }
                }

                // Same sweep for the semantic index: vec0 gets no FK
                // cascade, so meetings hard-deleted before
                // purge_meeting_vectors existed left their transcript
                // text searchable. One-time-per-launch cleanup.
                match database.prune_orphaned_vectors() {
                    Ok(0) => {}
                    Ok(n) => log::info!("pruned {} orphaned semantic-index row(s)", n),
                    Err(e) => log::warn!("semantic-index orphan sweep failed: {}", e),
                }
            }

            app.manage(database);
            app.manage(AppState::new());

            // Audio retention (plan v7 lifetime 16, opt-in, off by default):
            // reclaim WAVs of complete meetings past the user's window —
            // never rows, notes, or transcripts. Startup + once a day.
            // MUST run after app.manage(database): run_audio_retention reads
            // managed state, and an unmanaged-state panic inside setup
            // cannot unwind — it aborts the whole launch.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    commands::meetings::run_audio_retention(&handle);
                    commands::meetings::run_trash_retention(&handle);
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
                        commands::meetings::run_audio_retention(&handle);
                        commands::meetings::run_trash_retention(&handle);
                    }
                });
            }

            // DB hygiene (plan v7 #19): the daily backup is now a compacted
            // VACUUM INTO off the startup path (the old pre-open file copy
            // stalled launch by seconds on big files and remains only as
            // the pre-migration safety snapshot). Runs 2 minutes after
            // launch so it never competes with startup, then daily.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                        let h = handle.clone();
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            let db = h.state::<Database>();
                            if let Ok(dir) = h.path().app_data_dir() {
                                db.run_daily_maintenance(&dir);
                            }
                        })
                        .await;
                        tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60 - 120)).await;
                    }
                });
            }

            // Auto-generate the "About you" profile once enough enhanced
            // meetings exist. Hand-written text is never overwritten; our own
            // auto text refreshes at most weekly. Runs well after startup so
            // it never competes with launch work.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(45)).await;
                    let db = app_handle.state::<Database>();
                    let current = db.get_setting("user_context").ok().flatten().unwrap_or_default();
                    // Three-state ownership: "false" = the user explicitly took
                    // ownership (manual edit — even clearing the field), "true" =
                    // we generated it, unset = the feature has never run.
                    let auto_setting = db.get_setting("user_context_auto").ok().flatten();
                    if auto_setting.as_deref() == Some("false") {
                        return; // user owns this field — even when it's empty
                    }
                    let auto = auto_setting.as_deref() == Some("true");
                    if !current.trim().is_empty() && !auto {
                        return; // pre-feature hand-written text — never touch it
                    }
                    let stale = db
                        .get_setting("user_context_generated_at")
                        .ok()
                        .flatten()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                        .map(|t| chrono::Utc::now().signed_duration_since(t).num_days() >= 7)
                        .unwrap_or(true);
                    if !current.trim().is_empty() && !stale {
                        return;
                    }
                    match commands::chat::build_user_context_from_meetings(&db).await {
                        Ok(text) => {
                            // Flags before text: a crash mid-write then re-generates
                            // next launch (benign) instead of freezing a half-state.
                            let _ = db.set_setting("user_context_auto", "true");
                            let _ = db.set_setting(
                                "user_context_generated_at",
                                &chrono::Utc::now().to_rfc3339(),
                            );
                            let _ = db.set_setting("user_context", &text);
                            log::info!("auto-generated About-you profile from meeting history");
                            let _ = app_handle.emit("user-context-generated", &text);
                        }
                        // No key / too few meetings are normal early states.
                        Err(e) => log::info!("About-you auto-generation skipped: {}", e),
                    }
                });
            }

            // Backfill the semantic-recall index for meetings transcribed
            // before the feature existed (or while Ollama was down). Waits
            // out the launch rush; silently does nothing when recall is off.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let db = app_handle.state::<Database>();
                    ai::embeddings::backfill(&db).await;
                });
            }

            // Launch-flash fix, part 2: the window starts hidden and the
            // frontend shows it after first paint. If the webview ever fails
            // to boot, this fallback guarantees the app still appears.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                    if let Some(w) = app_handle.get_webview_window("main") {
                        if !w.is_visible().unwrap_or(true) {
                            log::warn!("frontend never showed the window; forcing visible");
                            let _ = w.show();
                        }
                    }
                });
            }

            // perchnote:// deep links (plan v3 rank 11, plan v8 B5): every
            // verb travels as one wire-shaped `deep-action` event; the
            // frontend's dispatchDeepAction handles it (same payload the
            // cold-start drain returns, so the two paths can't drift).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    // Cold start: macOS delivers the launch URL here AND
                    // stores it for get_current() — handling it now would
                    // double-fire callbacks (and, in a narrow window, the
                    // action). Until the frontend's drain has run, every
                    // URL belongs to the drain (QA audit finding 3).
                    if !commands::deeplinks::launch_drain_completed() {
                        for url in event.urls() {
                            log::info!("deep link deferred to cold-start drain: {url}");
                        }
                        return;
                    }
                    // A link is an explicit "bring Perchnote forward" —
                    // the window may be hidden (close button hides), and
                    // navigating an invisible webview helps no one
                    // (QA audit finding 5).
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    for url in event.urls() {
                        let (action, callbacks) = deeplink::parse_deep_link_full(url.as_str());
                        let dispatched = action.is_some();
                        match action {
                            Some(a) => {
                                let _ = app_handle
                                    .emit("deep-action", commands::deeplinks::wire_action(a));
                            }
                            None => log::info!("ignored deep link: {url}"),
                        }
                        commands::deeplinks::complete_callbacks(
                            dispatched,
                            &callbacks,
                            "unrecognized perchnote:// link",
                        );
                    }
                });
            }

            // Call detection (plan v3 rank 1): when a meeting app starts
            // using the microphone and we're not recording, nudge once.
            // Reads WHICH processes capture the mic — never any audio.
            {
                use tauri_plugin_notification::NotificationExt;
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut detector = audio::calldetect::CallDetector::new(15 * 60);
                    let started = std::time::Instant::now();
                    let mut interval =
                        tokio::time::interval(std::time::Duration::from_secs(15));
                    loop {
                        interval.tick().await;
                        let db = app_handle.state::<Database>();
                        let enabled = db
                            .get_setting("call_detection")
                            .ok()
                            .flatten()
                            .as_deref()
                            != Some("false");
                        let recording = app_handle
                            .state::<AppState>()
                            .recording
                            .lock()
                            .map(|r| r.is_recording)
                            .unwrap_or(false);
                        if !enabled || recording {
                            continue;
                        }
                        let active = audio::system::mic_active_bundle_ids();
                        let nudges =
                            detector.observe(started.elapsed().as_secs(), &active);
                        for bundle in nudges {
                            let app_name = audio::calldetect::call_app_name(&bundle)
                                .unwrap_or("a meeting app");
                            // Attach to the calendar event we're probably in.
                            let near = db.meeting_near_now(15).ok().flatten();
                            let body = match &near {
                                Some(m) => format!("\"{}\" — record it?", m.title),
                                None => "Record it in Perchnote?".to_string(),
                            };
                            let _ = app_handle
                                .notification()
                                .builder()
                                .title(format!("In a call on {app_name}?"))
                                .body(&body)
                                .show();
                            let _ = app_handle.emit(
                                "call-detected",
                                serde_json::json!({
                                    "app_name": app_name,
                                    "meeting_id": near.as_ref().map(|m| m.id.clone()),
                                    "meeting_title": near.as_ref().map(|m| m.title.clone()),
                                }),
                            );
                            log::info!("call detected via {bundle} ({app_name})");
                        }
                    }
                });
            }

            // Start calendar background polling
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
                loop {
                    interval.tick().await;

                    let db = app_handle.state::<Database>();

                    // Read date range settings
                    let past_days: u32 = db.get_setting("calendar_sync_past_days")
                        .ok().flatten()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(7);
                    let future_days: u32 = db.get_setting("calendar_sync_future_days")
                        .ok().flatten()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(30);

                    // --- Sync ICS calendars ---
                    let ics_urls: Vec<String> = db.get_setting("ics_calendar_urls")
                        .ok()
                        .flatten()
                        .and_then(|json| serde_json::from_str(&json).ok())
                        .unwrap_or_default();

                    for url in &ics_urls {
                        match calendar::ics::sync_ics_url(&db, url, past_days, future_days).await {
                            Ok(count) => {
                                if count > 0 {
                                    let _ = app_handle.emit("calendar-synced", count);
                                }
                            }
                            Err(e) => log::warn!("ICS sync error: {}", e),
                        }
                    }

                    // --- Sync Google Calendar (if connected) ---
                    let tokens_json = match secrets::get(secrets::SecretKey::GoogleOAuthTokens) {
                        Ok(Some(t)) if !t.is_empty() => Some(t),
                        _ => None,
                    };

                    if let Some(tokens_json) = tokens_json {
                        if let Ok(cal) = calendar::google::GoogleCalendar::from_db(&db) {
                            if let Ok(mut tokens) = serde_json::from_str::<calendar::google::OAuthTokens>(&tokens_json) {
                                if chrono::Utc::now().timestamp() >= tokens.expires_at {
                                    if let Ok(new_tokens) = cal.refresh_token(&tokens.refresh_token).await {
                                        let json = serde_json::to_string(&new_tokens).unwrap_or_default();
                                        let _ = secrets::set(secrets::SecretKey::GoogleOAuthTokens, &json);
                                        tokens = new_tokens;
                                    }
                                }

                                match cal.sync_events(&db, &tokens.access_token, past_days, future_days).await {
                                    Ok(count) => {
                                        if count > 0 {
                                            let _ = app_handle.emit("calendar-synced", count);
                                        }
                                    }
                                    Err(e) => log::warn!("calendar sync error: {}", e),
                                }
                            }
                        }
                    }

                    // --- Sync Microsoft Calendar (if connected) ---
                    let ms_tokens_json = match secrets::get(secrets::SecretKey::MicrosoftOAuthTokens) {
                        Ok(Some(t)) if !t.is_empty() => Some(t),
                        _ => None,
                    };

                    if let Some(ms_tj) = ms_tokens_json {
                        if let Ok(cal) = calendar::microsoft::MicrosoftCalendar::from_db(&db) {
                            if let Ok(mut tokens) = serde_json::from_str::<calendar::microsoft::MsOAuthTokens>(&ms_tj) {
                                if chrono::Utc::now().timestamp() >= tokens.expires_at {
                                    if let Ok(new_tokens) = cal.refresh_token(&tokens.refresh_token).await {
                                        let json = serde_json::to_string(&new_tokens).unwrap_or_default();
                                        let _ = secrets::set(secrets::SecretKey::MicrosoftOAuthTokens, &json);
                                        tokens = new_tokens;
                                    }
                                }

                                match cal.sync_events(&db, &tokens.access_token, past_days, future_days).await {
                                    Ok(count) => {
                                        if count > 0 {
                                            let _ = app_handle.emit("calendar-synced", count);
                                        }
                                    }
                                    Err(e) => log::warn!("Microsoft calendar sync error: {}", e),
                                }
                            }
                        }
                    }

                    // --- Daily 9am task digest (plan rank 7) ---
                    {
                        use chrono::Timelike;
                        use tauri_plugin_notification::NotificationExt;
                        let now_local = chrono::Local::now();
                        if now_local.hour() == 9 {
                            let today = now_local.format("%Y-%m-%d").to_string();
                            let last = db.get_setting("task_digest_last_sent").ok().flatten();
                            if last.as_deref() != Some(today.as_str()) {
                                if let Ok(items) = db.list_action_items() {
                                    let (mut due_today, mut overdue) = (0usize, 0usize);
                                    let today_str = today.clone();
                                    for it in items.iter().filter(|i| {
                                        !i.done
                                            && !i.dropped
                                            && i.snoozed_until
                                                .as_deref()
                                                .map(|s| s <= today_str.as_str())
                                                .unwrap_or(true)
                                    }) {
                                        if let Some(d) = it.deadline.as_deref().and_then(|s| s.get(..10)) {
                                            if d == today {
                                                due_today += 1;
                                            } else if d < today.as_str() {
                                                overdue += 1;
                                            }
                                        }
                                    }
                                    if due_today + overdue > 0 {
                                        let mut parts = Vec::new();
                                        if due_today > 0 {
                                            parts.push(format!("{} due today", due_today));
                                        }
                                        if overdue > 0 {
                                            parts.push(format!("{} overdue", overdue));
                                        }
                                        // Monday's edition doubles as the
                                        // week-in-review nudge (plan v5).
                                        use chrono::Datelike;
                                        let monday = now_local.weekday() == chrono::Weekday::Mon;
                                        let body = format!(
                                            "{} — open Tasks (⌘2) to follow up.{}",
                                            parts.join(", "),
                                            if monday { " Your week in review is waiting there." } else { "" }
                                        );
                                        let _ = app_handle
                                            .notification()
                                            .builder()
                                            .title("Perchnote tasks")
                                            .body(&body)
                                            .show();
                                    }
                                }
                                // Mark even when empty so we don't rescan all hour.
                                let _ = db.set_setting("task_digest_last_sent", &today);
                            }
                        }
                    }

                    // --- Check for upcoming meetings & auto-create (Items 144) ---
                    if let Ok(meetings) = db.list_meetings() {
                        let now = chrono::Utc::now();
                        for meeting in meetings {
                            if meeting.status != "upcoming" {
                                continue;
                            }
                            if let Some(start) = &meeting.scheduled_start {
                                if let Ok(start_time) = chrono::DateTime::parse_from_rfc3339(start) {
                                    let diff = start_time.signed_duration_since(now);
                                    // Auto-mark as "ready" 5 minutes before 
                                    if diff.num_seconds() > 0 && diff.num_seconds() <= 300 {
                                        let _ = db.update_meeting_status(&meeting.id, "ready");
                                        let _ = app_handle.emit("meeting-starting-soon", &meeting);
                                    } else if diff.num_seconds() > 0 && diff.num_seconds() <= 120 {
                                        let _ = app_handle.emit("meeting-starting-soon", &meeting);
                                    }
                                }
                            }
                        }
                    }
                }
            });

            // Start pre-meeting notification loop (every 30 seconds, fires ~1 min before)
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_notification::NotificationExt;
                    // Wait 30s on startup before first check so calendar has time to sync
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
                    loop {
                        interval.tick().await;

                        let db = app_handle.state::<Database>();
                        let state = app_handle.state::<AppState>();

                        // Respect notifications_enabled setting (default on)
                        let enabled = db.get_setting("notifications_enabled")
                            .ok().flatten()
                            .map(|v| v != "false")
                            .unwrap_or(true);
                        if !enabled {
                            continue;
                        }

                        // Read configurable settings
                        let notify_secs: i64 = db.get_setting("notification_minutes_before")
                            .ok().flatten()
                            .and_then(|v| v.parse::<i64>().ok())
                            .unwrap_or(1) * 60;
                        let min_attendees: usize = db.get_setting("notification_min_attendees")
                            .ok().flatten()
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(2);

                        if let Ok(meetings) = db.list_meetings() {
                            let now = chrono::Utc::now();
                            for meeting in &meetings {
                                // Only calendar-synced meetings (have a scheduled start)
                                let Some(start_str) = &meeting.scheduled_start else { continue };
                                let Ok(start_time) = chrono::DateTime::parse_from_rfc3339(start_str) else { continue };

                                let diff = start_time.signed_duration_since(now).num_seconds();
                                // Notify in a ±30s window around the configured lead time
                                let window_lo = notify_secs - 30;
                                let window_hi = notify_secs + 30;
                                if diff < window_lo || diff > window_hi {
                                    continue;
                                }

                                // Require minimum attendees per setting
                                let attendees: Vec<String> =
                                    serde_json::from_str(&meeting.attendees).unwrap_or_default();
                                if attendees.len() < min_attendees {
                                    continue;
                                }

                                // Deduplicate — only notify once per meeting per session.
                                // A poisoned lock must not kill the whole loop; skip the
                                // meeting rather than panic (and crash) or double-notify.
                                {
                                    let Ok(mut notified) = state.notified_meetings.lock() else {
                                        log::error!("notified_meetings lock poisoned; skipping notification");
                                        continue;
                                    };
                                    if notified.contains(&meeting.id) {
                                        continue;
                                    }
                                    notified.insert(meeting.id.clone());
                                }

                                // Set pending navigation so clicking the notification opens the meeting
                                if let Ok(mut pending) = state.pending_navigation.lock() {
                                    *pending = Some(meeting.id.clone());
                                }

                                // Build notification body
                                let body = {
                                    let platform = meeting.platform.as_str();
                                    let has_url = meeting.meeting_url
                                        .as_deref()
                                        .map(|u| !u.is_empty())
                                        .unwrap_or(false);
                                    let mins = notify_secs / 60;
                                    let time_str = if mins == 1 {
                                        "~1 minute".to_string()
                                    } else {
                                        format!("~{} minutes", mins)
                                    };
                                    if has_url && platform != "unknown" {
                                        format!("Starting in {} · {}", time_str, platform)
                                    } else {
                                        format!("Starting in {}", time_str)
                                    }
                                };

                                let _ = app_handle
                                    .notification()
                                    .builder()
                                    .title(&meeting.title)
                                    .body(&body)
                                    .show();

                                let _ = app_handle.emit("meeting-starting-soon", meeting);
                                log::info!("notification: sent for meeting {}", meeting.id);
                            }
                        }
                    }
                });
            }

            // Hide window instead of quitting; emit open-meeting when refocused after notification click
            if let Some(main_window) = app.get_webview_window("main") {
                let win = main_window.clone();
                let app_h = app.handle().clone();
                main_window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = win.hide();
                        }
                        tauri::WindowEvent::Focused(true) => {
                            // Extract pending navigation ID inside a tight scope so the
                            // State wrapper and MutexGuard are dropped before emit.
                            let meeting_id: Option<String> = {
                                let state = app_h.state::<AppState>();
                                state.pending_navigation.lock()
                                    .ok()
                                    .and_then(|mut g| g.take())
                            };
                            if let Some(id) = meeting_id {
                                let _ = win.emit("open-meeting", &id);
                            }
                        }
                        _ => {}
                    }
                });
            }

            // --- macOS application menu (File / Edit / View / Window) ---
            {
                let file_new = MenuItemBuilder::with_id("file_new_meeting", "New Meeting")
                    .accelerator("CmdOrCtrl+N")
                    .build(app)?;
                let file_prefs = MenuItemBuilder::with_id("file_preferences", "Preferences…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&file_new)
                    .separator()
                    .item(&file_prefs)
                    .separator()
                    .item(&PredefinedMenuItem::close_window(app, None)?)
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .item(&PredefinedMenuItem::undo(app, None)?)
                    .item(&PredefinedMenuItem::redo(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(app, None)?)
                    .item(&PredefinedMenuItem::copy(app, None)?)
                    .item(&PredefinedMenuItem::paste(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::select_all(app, None)?)
                    .build()?;

                let view_sidebar = MenuItemBuilder::with_id("view_toggle_sidebar", "Toggle Sidebar")
                    .accelerator("CmdOrCtrl+B")
                    .build(app)?;
                let view_focus = MenuItemBuilder::with_id("view_toggle_focus", "Focus Mode")
                    .accelerator("CmdOrCtrl+\\")
                    .build(app)?;
                let view_ask_ai = MenuItemBuilder::with_id("view_ask_ai", "Ask AI…")
                    .accelerator("CmdOrCtrl+J")
                    .build(app)?;
                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&view_sidebar)
                    .item(&view_focus)
                    .item(&view_ask_ai)
                    .separator()
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .build()?;

                let window_menu = SubmenuBuilder::new(app, "Window")
                    .item(&PredefinedMenuItem::minimize(app, None)?)
                    .item(&PredefinedMenuItem::maximize(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::close_window(app, None)?)
                    .build()?;

                let app_menu = MenuBuilder::new(app)
                    .item(&file_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .build()?;

                app.set_menu(app_menu)?;

                app.on_menu_event(|app_handle, event| {
                    match event.id().as_ref() {
                        "file_new_meeting" => {
                            app_handle.emit("menu-new-meeting", ()).ok();
                            if let Some(win) = app_handle.get_webview_window("main") {
                                win.show().ok();
                                win.set_focus().ok();
                            }
                        }
                        "file_preferences" => {
                            app_handle.emit("menu-preferences", ()).ok();
                            if let Some(win) = app_handle.get_webview_window("main") {
                                win.show().ok();
                                win.set_focus().ok();
                            }
                        }
                        "view_toggle_sidebar" => {
                            app_handle.emit("menu-toggle-sidebar", ()).ok();
                        }
                        "view_toggle_focus" => {
                            app_handle.emit("menu-toggle-focus", ()).ok();
                        }
                        "view_ask_ai" => {
                            app_handle.emit("menu-ask-ai", ()).ok();
                        }
                        _ => {}
                    }
                });
            }

            // --- Items 64, 65: System tray icon with recording indicator ---
            {
                let new_meeting = MenuItemBuilder::with_id("new_meeting", "New Meeting")
                    .accelerator("CmdOrCtrl+N")
                    .build(app)?;
                let toggle_recording = MenuItemBuilder::with_id("toggle_recording", "Start/Stop Recording").build(app)?;
                let quick_note = MenuItemBuilder::with_id("quick_note", "Quick Voice Note").build(app)?;
                let preferences = MenuItemBuilder::with_id("tray_preferences", "Preferences…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                let show_window = MenuItemBuilder::with_id("show_window", "Show Window").build(app)?;
                let quit = MenuItemBuilder::with_id("quit", "Quit Perchnote").build(app)?;

                let menu = MenuBuilder::new(app)
                    .item(&new_meeting)
                    .item(&quick_note)
                    .item(&toggle_recording)
                    .separator()
                    .item(&preferences)
                    .item(&show_window)
                    .separator()
                    .item(&quit)
                    .build()?;

                // Tray icon is best-effort — a missing bundle icon must not
                // abort app startup.
                // Addressable id so the recording loop can live-update the
                // menu-bar title with the elapsed timer.
                let tray_builder = match app.default_window_icon().cloned() {
                    Some(icon) => TrayIconBuilder::with_id("main-tray").icon(icon),
                    None => {
                        log::warn!("no default window icon available for the tray");
                        TrayIconBuilder::with_id("main-tray")
                    }
                };
                let _tray = tray_builder
                    .tooltip("Perchnote")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        // `Click` fires on both mouse-down and mouse-up. If we
                        // toggle on every event we get two toggles per click —
                        // the window flashes visible and immediately hides.
                        // Act only on the Up edge, and only for left clicks
                        // (right click shows the menu via the OS).
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app_handle = tray.app_handle();
                            if let Some(window) = app_handle.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    })
                    .on_menu_event(move |app_handle, event| {
                        match event.id().as_ref() {
                            "new_meeting" => {
                                let _ = app_handle.emit("tray-new-meeting", ());
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            // Quick voice note (plan v11 #1): capture a thought
                            // without ceremony — the frontend creates a tagged
                            // voice-note meeting and starts recording immediately.
                            "quick_note" => {
                                let _ = app_handle.emit("tray-quick-note", ());
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            "toggle_recording" => {
                                let _ = app_handle.emit("tray-toggle-recording", ());
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            "tray_preferences" | "show_window" => {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                                if event.id().as_ref() == "tray_preferences" {
                                    app_handle.emit("menu-preferences", ()).ok();
                                }
                            }
                            "quit" => {
                                // Quit during a recording used to kill the
                                // process mid-write: undrained transcription
                                // lost, meeting stuck "recording" until the
                                // next launch silently repaired it (whole-app
                                // review P2). Stop properly first; exit when
                                // the drain settles or after a hard cap.
                                let recording = app_handle
                                    .state::<AppState>()
                                    .recording
                                    .lock()
                                    .map(|r| r.is_recording)
                                    .unwrap_or(false);
                                if recording {
                                    let handle = app_handle.clone();
                                    tauri::async_runtime::spawn(async move {
                                        let stop = commands::audio::stop_recording(
                                            handle.clone(),
                                            handle.state(),
                                            handle.state(),
                                        );
                                        let _ = tokio::time::timeout(
                                            std::time::Duration::from_secs(20),
                                            stop,
                                        )
                                        .await;
                                        handle.exit(0);
                                    });
                                } else {
                                    app_handle.exit(0);
                                }
                            }
                            id if id.starts_with("open_meeting:") => {
                                let meeting_id = id["open_meeting:".len()..].to_string();
                                let _ = app_handle.emit("tray-open-meeting", meeting_id);
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            _ => {}
                        }
                    })
                    .build(app)?;

                // Recent meetings in the tray (plan v11 #3): the first tick
                // fires immediately, replacing the static menu above with
                // the recents-aware one; later ticks absorb renames and new
                // meetings. 60s is plenty for a menu nobody watches live.
                {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let mut interval =
                            tokio::time::interval(std::time::Duration::from_secs(60));
                        loop {
                            interval.tick().await;
                            rebuild_tray_menu(&handle);
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // audio
            commands::audio::list_audio_devices,
            commands::audio::list_output_devices,
            commands::audio::check_system_audio_permission,
            commands::audio::request_system_audio_permission,
            commands::audio::start_recording,
            commands::audio::stop_recording,
            commands::audio::pause_recording,
            commands::audio::resume_recording,
            commands::audio::get_recording_path,
            commands::audio::generate_meeting_notes,
            commands::audio::is_recording,
            commands::audio::highlight_moment,
            commands::audio::get_talk_stats,
            commands::audio::toggle_segment_highlight,
            commands::audio::update_segment_text,
            commands::audio::replace_in_transcript,
            commands::import::import_audio_file,
            commands::audio::is_paused,
            commands::audio::delete_transcript_segment,
            commands::audio::check_ai_configured,
            commands::audio::is_ollama_running,
            commands::audio::list_ollama_models,
            commands::audio::is_apple_ai_available,
            commands::audio::speech_engine_available,
            commands::audio::list_anthropic_models,
            commands::audio::list_mention_candidates,
            commands::audio::batch_retranscribe,
            commands::audio::get_recording_meeting_id,
            // meetings
            commands::meetings::create_meeting,
            commands::meetings::get_meeting,
            commands::meetings::list_meetings,
            commands::meetings::update_meeting_title,
            commands::meetings::update_meeting_metadata,
            commands::meetings::update_meeting_status,
            commands::meetings::delete_meeting,
            commands::meetings::soft_delete_meeting,
            commands::meetings::restore_meeting,
            commands::meetings::toggle_pin_meeting,
            commands::meetings::archive_meeting,
            commands::meetings::unarchive_meeting,
            commands::meetings::list_archived_meetings,
            commands::meetings::list_deleted_meetings,
            commands::meetings::upsert_speaker_label,
            commands::meetings::list_speaker_labels,
            commands::meetings::list_speaker_labels_for_meeting,
            commands::meetings::delete_speaker_label,
            commands::meetings::link_meetings,
            commands::meetings::unlink_meetings,
            commands::meetings::get_linked_meetings,
            commands::meetings::get_storage_stats,
            commands::meetings::list_note_previews,
            commands::meetings::empty_trash,
            commands::meetings::get_storage_breakdown,
            commands::meetings::preview_audio_retention,
            commands::meetings::set_audio_keep,
            commands::meetings::delete_meeting_audio,
            commands::meetings::export_all_data,
            // notes
            commands::notes::create_note,
            commands::notes::get_note_by_meeting,
            commands::notes::get_or_create_note,
            commands::notes::update_note_raw_content,
            commands::notes::update_note_contents,
            commands::notes::export_tasks_to_reminders,
            commands::notes::pull_reminder_completions,
            commands::notes::set_task_snooze,
            commands::notes::set_task_dropped,
            commands::notes::update_note_generated_content,
            commands::notes::update_note_contents_with_receipt,
            commands::notes::restore_previous_notes,
            commands::notes::get_transcript_sha,
            commands::notes::get_transcript_by_meeting,
            commands::notes::rediarize_transcript,
            commands::notes::list_action_items,
            commands::notes::open_loops_for_meeting,
            commands::notes::last_time_in_series,
            commands::notes::set_action_item_done,
            // chat
            commands::chat::create_chat_message,
            commands::chat::list_chat_messages,
            commands::chat::chat_with_meeting,
            commands::chat::generate_user_context,
            commands::chat::chat_with_meetings,
            commands::chat::catch_me_up,
            commands::chat::ai_search_meetings,
            commands::chat::generate_agenda,
            commands::chat::merge_meetings,
            commands::chat::import_transcript,
            commands::chat::run_retention_policy,
            // templates
            commands::templates::list_templates,
            commands::templates::get_default_template,
            commands::templates::create_template,
            commands::templates::update_template,
            commands::templates::delete_template,
            // folders
            commands::folders::create_folder,
            commands::folders::list_folders,
            commands::folders::add_meeting_to_folder,
            commands::folders::remove_meeting_from_folder,
            commands::folders::delete_folder,
            commands::folders::delete_folder_recursive,
            commands::folders::get_meeting_ids_in_folder,
            commands::folders::get_folder_memberships_map,
            commands::folders::get_meeting_folders,
            commands::folders::get_meetings_in_folder,
            commands::folders::reorder_folders,
            commands::folders::move_folder,
            // tags
            commands::tags::list_tags,
            commands::tags::get_meeting_tags,
            commands::tags::get_tags_for_meetings,
            commands::tags::add_tag_to_meeting,
            commands::tags::remove_tag_from_meeting,
            commands::tags::create_tag,
            commands::tags::delete_tag,
            // settings
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_app_paths,
            commands::settings::list_whisper_models,
            commands::settings::download_whisper_model,
            commands::settings::set_custom_storage_path,
            commands::settings::reveal_in_finder,
            commands::settings::open_url,
            commands::settings::write_clipboard,
            commands::deeplinks::take_launch_deep_actions,
            commands::settings::rename_folder,
            commands::settings::update_folder,
            // Database health check
            commands::settings::check_database_health,
            // Attachments
            commands::settings::add_attachment,
            commands::settings::save_pasted_image,
            commands::settings::list_attachments,
            commands::settings::delete_attachment,
            commands::settings::open_attachment,
            commands::settings::save_markdown_export,
            commands::settings::export_backup_archive,
            commands::settings::verify_backup_archive,
            commands::settings::list_backup_archives,
            commands::settings::restore_backup_archive,
            commands::settings::restart_app,
            commands::settings::notify_user,
            commands::settings::write_md_mirror,
            commands::settings::download_vad_model,
            commands::settings::check_for_update,
            commands::settings::vad_model_ready,
            // search
            commands::search::search_transcripts,
            commands::search::search_all,
            commands::search::semantic_search,
            commands::search::search_with_semantic,
            commands::search::embedding_status,
            // insights
            commands::insights::get_topic_trends,
            commands::insights::get_monthly_narrative,
            commands::insights::generate_monthly_narrative,
            commands::insights::get_period_narrative,
            commands::insights::generate_period_narrative,
            commands::insights::export_brag_doc,
            // calendar - Google
            commands::calendar::start_google_oauth,
            commands::calendar::sync_calendar,
            commands::calendar::is_calendar_connected,
            commands::calendar::has_calendar_credentials,
            commands::calendar::disconnect_calendar,
            // calendar - ICS
            commands::calendar::add_ics_url,
            commands::calendar::remove_ics_url,
            commands::calendar::list_ics_urls,
            commands::calendar::sync_ics_calendars,
            // calendar - Microsoft 
            commands::calendar::start_microsoft_oauth,
            commands::calendar::sync_microsoft_calendar,
            commands::calendar::is_microsoft_connected,
            commands::calendar::has_microsoft_credentials,
            commands::calendar::disconnect_microsoft,
            // calendar - Auto-create 
            commands::calendar::auto_create_from_calendar,
            // sharing - HTML export 
            commands::calendar::export_meeting_html,
            // sharing - Slack 
            commands::calendar::share_to_slack,
            // voice profiles 
            commands::voice::save_voice_profile,
            commands::voice::list_voice_profiles,
            commands::voice::delete_voice_profile,
            // speaker recognition 
            commands::voice::unknown_speakers_for_meeting,
            commands::voice::identify_speaker,
            commands::voice::recluster_speakers,
            commands::voice::merge_speakers,
            commands::voice::get_recording_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
