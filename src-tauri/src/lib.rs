mod ai;
mod audio;
mod calendar;
mod commands;
mod db;
mod secrets;
mod state;
mod transcription;

use db::Database;
use state::AppState;
use tauri::{Emitter, Manager};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let database = Database::new(app_data_dir)
                .expect("failed to initialize database");

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
                        let count = conn.execute(
                            "UPDATE meetings SET is_archived = 1, updated_at = ?1
                             WHERE is_archived = 0 AND deleted_at IS NULL
                             AND COALESCE(scheduled_start, created_at) < ?2",
                            rusqlite::params![chrono::Utc::now().to_rfc3339(), cutoff_str],
                        ).unwrap_or(0);
                        if count > 0 {
                            log::info!("Retention policy: archived {} old meetings", count);
                        }
                    }
                }
            }

            app.manage(database);
            app.manage(AppState::new());

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

                                // Deduplicate — only notify once per meeting per session
                                {
                                    let mut notified = state.notified_meetings.lock().unwrap();
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
                                log::info!("notification: sent for meeting {}", meeting.title);
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
                let toggle_recording = MenuItemBuilder::with_id("toggle_recording", "Start Recording").build(app)?;
                let preferences = MenuItemBuilder::with_id("tray_preferences", "Preferences…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                let show_window = MenuItemBuilder::with_id("show_window", "Show Window").build(app)?;
                let quit = MenuItemBuilder::with_id("quit", "Quit Perchnote").build(app)?;

                let menu = MenuBuilder::new(app)
                    .item(&new_meeting)
                    .item(&toggle_recording)
                    .separator()
                    .item(&preferences)
                    .item(&show_window)
                    .separator()
                    .item(&quit)
                    .build()?;

                let _tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().cloned().unwrap())
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
                                app_handle.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // audio
            commands::audio::list_audio_devices,
            commands::audio::list_output_devices,
            commands::audio::start_recording,
            commands::audio::stop_recording,
            commands::audio::pause_recording,
            commands::audio::resume_recording,
            commands::audio::get_recording_path,
            commands::audio::generate_meeting_notes,
            commands::audio::is_recording,
            commands::audio::is_paused,
            commands::audio::delete_transcript_segment,
            commands::audio::check_ai_configured,
            commands::audio::is_ollama_running,
            commands::audio::list_ollama_models,
            commands::audio::is_apple_ai_available,
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
            commands::meetings::export_all_data,
            // notes
            commands::notes::create_note,
            commands::notes::get_note_by_meeting,
            commands::notes::update_note_raw_content,
            commands::notes::update_note_generated_content,
            commands::notes::get_transcript_by_meeting,
            commands::notes::rediarize_transcript,
            // chat
            commands::chat::create_chat_message,
            commands::chat::list_chat_messages,
            commands::chat::chat_with_meeting,
            commands::chat::chat_with_meetings,
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
            commands::folders::get_meeting_folders,
            commands::folders::get_meetings_in_folder,
            commands::folders::reorder_folders,
            commands::folders::move_folder,
            // tags
            commands::tags::list_tags,
            commands::tags::get_meeting_tags,
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
            commands::settings::rename_folder,
            commands::settings::update_folder,
            // Database health check
            commands::settings::check_database_health,
            // Attachments
            commands::settings::add_attachment,
            commands::settings::list_attachments,
            commands::settings::delete_attachment,
            commands::settings::open_attachment,
            commands::settings::save_markdown_export,
            // search
            commands::search::search_transcripts,
            commands::search::search_all,
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
            commands::voice::get_recording_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
