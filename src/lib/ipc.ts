import { invoke } from "@tauri-apps/api/core";
import type { DeepActionWire } from "./deepActions";

// --- Types ---

export interface Meeting {
  id: string;
  title: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  calendar_event_id: string | null;
  attendees: string;
  location: string | null;
  meeting_url: string | null;
  platform: string;
  status: string;
  is_pinned: boolean;
  is_archived: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  device_name: string | null;
  system_audio_captured: boolean;
  note_status: "none" | "draft" | "enhanced";
}

export interface Note {
  id: string;
  meeting_id: string;
  raw_content: string | null;
  generated_content: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string;
  /** Enhance receipt (plan v10 #2): which provider/model wrote
   *  generated_content and when. All null for pre-migration-18 notes and
   *  never-enhanced notes — the UI renders NOTHING for those. */
  generated_provider?: string | null;
  generated_model?: string | null;
  generated_at?: string | null;
  /** sha256 of the segments JSON the generation read; compare against
   *  getTranscriptSha to detect "transcript changed after these notes". */
  generated_transcript_sha?: string | null;
  /** One-slot history: JSON envelope {content, provider, model,
   *  generated_at, transcript_sha} of the version a re-enhance replaced. */
  generated_previous?: string | null;
}

/** Parsed shape of Note.generated_previous. */
export interface PreviousGenerated {
  content?: string | null;
  provider?: string | null;
  model?: string | null;
  generated_at?: string | null;
  transcript_sha?: string | null;
}

export interface Transcript {
  id: string;
  meeting_id: string;
  segments: string;
  source: string;
  language: string;
  created_at: string;
}

export interface TopicTrend {
  term: string;
  counts: Array<{ month: string; meetings: number }>;
}

export interface StorageBreakdown {
  db_bytes: number;
  recordings_bytes: number;
  attachments_bytes: number;
  backups_bytes: number;
  largest: Array<{
    meeting_id: string;
    title: string;
    bytes: number;
    date: string | null;
    keep: boolean;
  }>;
}

export interface CachedInsight {
  key: string;
  content: string;
  /** The exact facts JSON the content was generated from. */
  facts: string;
  created_at: string;
}

export interface ActionItem {
  meeting_id: string;
  meeting_title: string;
  meeting_date: string | null;
  note_id: string;
  source: "raw" | "generated";
  index: number;
  task: string;
  assignee: string | null;
  deadline: string | null;
  done: boolean;
  /** Overlay: hidden from the default lens + digest until this date. */
  snoozed_until?: string | null;
  /** Overlay: consciously dropped in triage. */
  dropped?: boolean;
}

/** The previous meeting in a recurring series, for the pre-meeting "Last time" card. */
export interface LastTimeCard {
  meeting_id: string;
  title: string;
  date: string;
  summary: string;
  open_items: ActionItem[];
}

export interface ChatMessage {
  id: string;
  meeting_id: string | null;
  role: string;
  content: string;
  context_meeting_ids: string;
  created_at: string;
}

/** One numbered context block behind an Ask AI answer (plan v8 A5).
 * The answer's [n] tokens map onto these; session-only, never persisted. */
export interface ChatCitation {
  n: number;
  meeting_id: string;
  meeting_title: string;
  start_ms: number;
}

export interface ChatAnswer {
  answer: string;
  citations: ChatCitation[];
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  prompt_template: string;
  sections: string;
  is_default: boolean;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  name: string;
  color: string;
  icon: string;
  sort_order: number;
  parent_id: string | null;
  meeting_count: number;
  created_at: string;
  updated_at: string;
}

export interface FolderNode extends Folder {
  children: FolderNode[];
}

export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const map = new Map<string, FolderNode>();
  folders.forEach(f => map.set(f.id, { ...f, children: [] }));
  const roots: FolderNode[] = [];
  map.forEach(node => {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sort = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order);
    nodes.forEach(n => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function buildAncestorPath(folderId: string, folders: Folder[]): Folder[] {
  const map = new Map<string, Folder>(folders.map(f => [f.id, f]));
  const path: Folder[] = [];
  let current = map.get(folderId);
  while (current) {
    path.unshift(current);
    current = current.parent_id ? map.get(current.parent_id) : undefined;
  }
  return path;
}

export interface Tag {
  id: string;
  name: string;
  source: string;
  created_at: string;
}

export interface SearchResult {
  meeting_id: string;
  match_source: string;
  snippet: string;
  /** Transcript matches: start of the matching segment, for jump-to-moment. */
  match_start_ms?: number | null;
}

export interface SpeakerLabel {
  id: string;
  /** Meeting this label belongs to. null for legacy rows from before
   *  migration 11 (kept for export, ignored by per-meeting lookups). */
  meeting_id: string | null;
  speaker_key: string;
  display_name: string;
  color: string | null;
  /** Participant type — "in-room", "remote", or "phone" */
  participant_type: string;
  created_at: string;
}

/** Unknown speaker row returned by unknown_speakers_for_meeting */
export interface UnknownSpeaker {
  speaker_key: string;
  /** Current label, when the user has already named this speaker. */
  display_name: string | null;
  longest_start_ms: number;
  longest_end_ms: number;
  total_seconds: number;
  suggested_name: string | null;
  suggested_similarity: number | null;
}

/** Voice profile for speaker identification */
export interface VoiceProfile {
  id: string;
  speaker_name: string;
  sample_path: string;
  created_at: string;
}

export interface MeetingLink {
  source_meeting_id: string;
  target_meeting_id: string;
  link_type: string;
  created_at: string;
}

export interface StorageStats {
  total_meetings: number;
  total_transcripts: number;
  total_notes: number;
  total_chat_messages: number;
  db_size_bytes: number;
}

export interface AppPaths {
  data_dir: string;
  recordings_dir: string;
  models_dir: string;
  db_path: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  size: string;
  downloaded: boolean;
  path: string | null;
}

/** Result of a single meeting re-transcription attempt */
export interface RetranscribeResult {
  meeting_id: string;
  success: boolean;
  error: string | null;
}

/** Database health information */
export interface DatabaseHealth {
  schema_version: number;
  tables: string[];
  missing_tables: string[];
  healthy: boolean;
}

/** File attachment associated with a meeting */
export interface Attachment {
  id: string;
  meeting_id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number;
  created_at: string;
}

/** What one Markdown-mirror write actually did (plan v10 #9). */
export interface MirrorWriteResult {
  /** Absolute path written: the mirror file, or the `.conflict.md` beside it
   *  when the write conflicted. Empty when the mirror is disabled. */
  path: string;
  /** True when the on-disk file held an external edit, so the new content
   *  went to a `.conflict.md` instead of overwriting the user's file. */
  conflicted: boolean;
}

// --- IPC Functions ---

export const ipc = {
  // Meetings
  createMeeting: (title: string) => invoke<Meeting>("create_meeting", { title }),
  getMeeting: (id: string) => invoke<Meeting | null>("get_meeting", { id }),
  listMeetings: () => invoke<Meeting[]>("list_meetings").then((v) => v ?? []),
  updateMeetingTitle: (id: string, title: string) =>
    invoke<void>("update_meeting_title", { id, title }),
  updateMeetingMetadata: (
    id: string,
    fields: { scheduledStart?: string | null; scheduledEnd?: string | null; location?: string | null; attendees?: string | null }
  ) =>
    invoke<void>("update_meeting_metadata", {
      id,
      scheduledStart: fields.scheduledStart,
      scheduledEnd: fields.scheduledEnd,
      location: fields.location,
      attendees: fields.attendees,
    }),
  updateMeetingStatus: (id: string, status: string) =>
    invoke<void>("update_meeting_status", { id, status }),
  deleteMeeting: (id: string) =>
    invoke<void>("delete_meeting", { id }),
  softDeleteMeeting: (id: string) =>
    invoke<void>("soft_delete_meeting", { id }),
  restoreMeeting: (id: string) =>
    invoke<void>("restore_meeting", { id }),
  togglePinMeeting: (id: string) =>
    invoke<boolean>("toggle_pin_meeting", { id }),
  archiveMeeting: (id: string) =>
    invoke<void>("archive_meeting", { id }),
  unarchiveMeeting: (id: string) =>
    invoke<void>("unarchive_meeting", { id }),
  listArchivedMeetings: () => invoke<Meeting[]>("list_archived_meetings"),
  listDeletedMeetings: () => invoke<Meeting[]>("list_deleted_meetings").then((v) => v ?? []),

  // Notes
  createNote: (meetingId: string, templateId?: string) =>
    invoke<Note>("create_note", { meetingId, templateId }),
  getNoteByMeeting: (meetingId: string) =>
    invoke<Note | null>("get_note_by_meeting", { meetingId }),
  getOrCreateNote: (meetingId: string) =>
    invoke<Note>("get_or_create_note", { meetingId }),

  // Action item rollup (Tasks view)
  listActionItems: () => invoke<ActionItem[]>("list_action_items").then((v) => v ?? []),
  setActionItemDone: (
    noteId: string,
    source: string,
    index: number,
    done: boolean,
    task?: string,
  ) => invoke<void>("set_action_item_done", { noteId, source, index, done, task }),
  updateNoteRawContent: (id: string, rawContent: string) =>
    invoke<void>("update_note_raw_content", { id, rawContent }),
  updateNoteGeneratedContent: (id: string, generatedContent: string) =>
    invoke<void>("update_note_generated_content", { id, generatedContent }),
  /** Atomic raw+generated write; rawContent null leaves raw untouched. */
  updateNoteContents: (id: string, rawContent: string | null, generatedContent: string) =>
    invoke<void>("update_note_contents", { id, rawContent, generatedContent }),
  /** updateNoteContents + the enhance receipt (plan v10 #2): records which
   *  provider/model generated the notes and the transcript hash it read;
   *  the prior generated version moves into the one previous-version slot. */
  updateNoteContentsWithReceipt: (
    id: string,
    rawContent: string | null,
    generatedContent: string,
    provider: string,
    model: string,
    transcriptSha: string | null,
  ) =>
    invoke<void>("update_note_contents_with_receipt", {
      id, rawContent, generatedContent, provider, model, transcriptSha,
    }),
  /** Swap generated_content with the previous version — receipts swap too. */
  restorePreviousNotes: (id: string) => invoke<Note>("restore_previous_notes", { id }),
  /** Current transcript hash — the live side of receipt staleness. */
  getTranscriptSha: (meetingId: string) =>
    invoke<string | null>("get_transcript_sha", { meetingId }),

  // Transcripts
  getTranscriptByMeeting: (meetingId: string) =>
    invoke<Transcript | null>("get_transcript_by_meeting", { meetingId }),
  // Re-diarize transcript with adaptive speaker model
  deleteTranscriptSegment: (meetingId: string, segmentIndex: number) =>
    invoke<void>("delete_transcript_segment", { meetingId, segmentIndex }),

  // Recording controls
  startRecording: (
    meetingId: string,
    deviceName?: string | null,
    systemAudio?: boolean | null,
  ) =>
    invoke<void>("start_recording", {
      meetingId,
      deviceName: deviceName ?? null,
      systemAudio: systemAudio ?? null,
    }),
  stopRecording: () => invoke<string>("stop_recording"),
  pauseRecording: () => invoke<void>("pause_recording"),
  resumeRecording: () => invoke<void>("resume_recording"),
  isPaused: () => invoke<boolean>("is_paused"),

  // System-audio (Screen Recording) permission
  checkSystemAudioPermission: () =>
    invoke<boolean>("check_system_audio_permission"),
  requestSystemAudioPermission: () =>
    invoke<boolean>("request_system_audio_permission"),

  // Chat
  createChatMessage: (
    meetingId: string | null,
    role: string,
    content: string,
    contextMeetingIds: string
  ) => invoke<ChatMessage>("create_chat_message", { meetingId, role, content, contextMeetingIds }),
  listChatMessages: (meetingId?: string) =>
    invoke<ChatMessage[]>("list_chat_messages", { meetingId }),

  // Templates
  listTemplates: () => invoke<Template[]>("list_templates"),
  getDefaultTemplate: () => invoke<Template | null>("get_default_template"),
  createTemplate: (
    name: string,
    description: string | null,
    promptTemplate: string,
    sections: string,
    isDefault: boolean
  ) => invoke<Template>("create_template", { name, description, promptTemplate, sections, isDefault }),
  updateTemplate: (
    id: string,
    name: string,
    description: string | null,
    promptTemplate: string,
    sections: string,
    isDefault: boolean
  ) => invoke<void>("update_template", { id, name, description, promptTemplate, sections, isDefault }),
  deleteTemplate: (id: string) => invoke<void>("delete_template", { id }),

  // Folders
  createFolder: (name: string, color: string, icon: string, parentId?: string | null) =>
    invoke<Folder>("create_folder", { name, color, icon, parentId: parentId ?? null }),
  listFolders: () => invoke<Folder[]>("list_folders"),
  addMeetingToFolder: (meetingId: string, folderId: string) =>
    invoke<void>("add_meeting_to_folder", { meetingId, folderId }),
  removeMeetingFromFolder: (meetingId: string, folderId: string) =>
    invoke<void>("remove_meeting_from_folder", { meetingId, folderId }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),
  getMeetingIdsInFolder: (folderId: string) =>
    invoke<string[]>("get_meeting_ids_in_folder", { folderId }),
  /** Whole meeting→folders map in one round-trip (replaces per-folder N+1). */
  getFolderMembershipsMap: () =>
    invoke<Record<string, string[]>>("get_folder_memberships_map"),
  moveFolder: (id: string, newParentId: string | null) =>
    invoke<void>("move_folder", { id, newParentId }),
  deleteFolderRecursive: (id: string) =>
    invoke<void>("delete_folder_recursive", { id }),
  getMeetingFolders: (meetingId: string) =>
    invoke<Folder[]>("get_meeting_folders", { meetingId }),
  getMeetingsInFolder: (folderId: string) =>
    invoke<Meeting[]>("get_meetings_in_folder", { folderId }),

  // Tags
  listTags: () => invoke<Tag[]>("list_tags"),
  getMeetingTags: (meetingId: string) =>
    invoke<Tag[]>("get_meeting_tags", { meetingId }),
  /** Tags for many meetings in one round-trip; untagged meetings are absent. */
  getTagsForMeetings: (meetingIds: string[]) =>
    invoke<Record<string, Tag[]>>("get_tags_for_meetings", { meetingIds }),
  addTagToMeeting: (meetingId: string, tagId: string) =>
    invoke<void>("add_tag_to_meeting", { meetingId, tagId }),
  removeTagFromMeeting: (meetingId: string, tagId: string) =>
    invoke<void>("remove_tag_from_meeting", { meetingId, tagId }),
  createTag: (name: string, source?: string) =>
    invoke<Tag>("create_tag", { name, source }),
  deleteTag: (id: string) =>
    invoke<void>("delete_tag", { id }),

  // Speaker Labels — scoped per-meeting since migration 11.
  upsertSpeakerLabel: (meetingId: string, speakerKey: string, displayName: string, color?: string, participantType?: string) =>
    invoke<SpeakerLabel>("upsert_speaker_label", { meetingId, speakerKey, displayName, color, participantType }),
  /** All labels including legacy NULL-meeting rows. Use for export. */
  listSpeakerLabels: () => invoke<SpeakerLabel[]>("list_speaker_labels"),
  /** Labels belonging to one meeting. Excludes legacy NULL rows. */
  listSpeakerLabelsForMeeting: (meetingId: string) =>
    invoke<SpeakerLabel[]>("list_speaker_labels_for_meeting", { meetingId }),
  deleteSpeakerLabel: (id: string) =>
    invoke<void>("delete_speaker_label", { id }),

  // Voice Profiles 
  saveVoiceProfile: (name: string, audioData: number[]) =>
    invoke<VoiceProfile>("save_voice_profile", { name, audioData }),
  listVoiceProfiles: () => invoke<VoiceProfile[]>("list_voice_profiles"),
  deleteVoiceProfile: (id: string) =>
    invoke<void>("delete_voice_profile", { id }),

  // Meeting Links
  linkMeetings: (sourceId: string, targetId: string, linkType?: string) =>
    invoke<MeetingLink>("link_meetings", { sourceId, targetId, linkType }),
  unlinkMeetings: (sourceId: string, targetId: string) =>
    invoke<void>("unlink_meetings", { sourceId, targetId }),
  getLinkedMeetings: (meetingId: string) =>
    invoke<MeetingLink[]>("get_linked_meetings", { meetingId }),

  // Audio (items 131-140)
  listAudioDevices: () => invoke<string[]>("list_audio_devices"),
  getRecordingPath: (meetingId: string) =>
    invoke<string | null>("get_recording_path", { meetingId }),
  getRecordingMeetingId: () => invoke<string | null>("get_recording_meeting_id"),

  // Settings
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),

  // Calendar (ICS)
  addIcsUrl: (url: string) => invoke<void>("add_ics_url", { url }),
  removeIcsUrl: (url: string) => invoke<void>("remove_ics_url", { url }),
  listIcsUrls: () => invoke<string[]>("list_ics_urls"),
  syncIcsCalendars: (pastDays?: number, futureDays?: number) =>
    invoke<number>("sync_ics_calendars", { pastDays, futureDays }),

  // Calendar - Google OAuth
  startGoogleOAuth: () => invoke<string>("start_google_oauth"),
  syncGoogleCalendar: (pastDays?: number, futureDays?: number) =>
    invoke<number>("sync_calendar", { pastDays, futureDays }),
  isGoogleConnected: () => invoke<boolean>("is_calendar_connected"),
  hasGoogleCredentials: () => invoke<boolean>("has_calendar_credentials"),
  disconnectGoogle: () => invoke<void>("disconnect_calendar"),

  // Calendar - Microsoft 
  startMicrosoftOAuth: () => invoke<string>("start_microsoft_oauth"),
  syncMicrosoftCalendar: (pastDays?: number, futureDays?: number) =>
    invoke<number>("sync_microsoft_calendar", { pastDays, futureDays }),
  isMicrosoftConnected: () => invoke<boolean>("is_microsoft_connected"),
  hasMicrosoftCredentials: () => invoke<boolean>("has_microsoft_credentials"),
  disconnectMicrosoft: () => invoke<void>("disconnect_microsoft"),

  // Calendar - Auto-create 
  autoCreateFromCalendar: () => invoke<number>("auto_create_from_calendar"),

  // Sharing - HTML export 
  exportMeetingHtml: (meetingId: string) =>
    invoke<string>("export_meeting_html", { meetingId }),

  // Sharing - Slack 
  shareToSlack: (meetingId: string) =>
    invoke<void>("share_to_slack", { meetingId }),

  // Search
  searchTranscripts: (query: string, limit?: number) =>
    invoke<string[]>("search_transcripts", { query, limit }),
  searchAll: (query: string, limit?: number) =>
    invoke<SearchResult[]>("search_all", { query, limit }),
  /** searchAll + semantic recall fused into ONE meeting-level ranking
   *  (RRF server-side, plan v9 #10). Superset of searchAll's rows, grouped
   *  by meeting in fused order; meetings only the semantic arm found get
   *  one match_source "semantic" row ("Related:") with match_start_ms for
   *  jump-to-moment. Byte-identical to searchAll when embeddings are off. */
  searchWithSemantic: (query: string, limit?: number) =>
    invoke<SearchResult[]>("search_with_semantic", { query, limit }),

  // Storage / Backup
  getStorageStats: () => invoke<StorageStats>("get_storage_stats"),
  exportAllData: () => invoke<string>("export_all_data"),

  // App Paths & Models
  getAppPaths: () => invoke<AppPaths>("get_app_paths"),
  listWhisperModels: () => invoke<ModelInfo[]>("list_whisper_models"),
  isOllamaRunning: () => invoke<boolean>("is_ollama_running"),
  listOllamaModels: () => invoke<string[]>("list_ollama_models"),
  isAppleAiAvailable: () => invoke<boolean>("is_apple_ai_available"),
  /** Apple Speech transcription engine usable (macOS 26+, locale asset installed). */
  speechEngineAvailable: () => invoke<boolean>("speech_engine_available"),
  downloadWhisperModel: (modelId: string) =>
    invoke<string>("download_whisper_model", { modelId }),
  setCustomStoragePath: (pathType: string, path: string) =>
    invoke<void>("set_custom_storage_path", { pathType, path }),
  revealInFinder: (path: string) =>
    invoke<void>("reveal_in_finder", { path }),
  openUrl: (url: string) =>
    invoke<void>("open_url", { url }),
  writeClipboard: (text: string) =>
    invoke<void>("write_clipboard", { text }),

  // Folder management
  renameFolder: (id: string, name: string) =>
    invoke<void>("rename_folder", { id, name }),
  updateFolder: (id: string, name?: string, color?: string, icon?: string) =>
    invoke<void>("update_folder", { id, name, color, icon }),

  // AI chat with a single meeting (Ask AI "this meeting" scope; recipes)
  chatWithMeeting: (meetingId: string, question: string) =>
    invoke<string>("chat_with_meeting", { meetingId, question }),

  // AI chat with multiple meetings
  chatWithMeetings: (meetingIds: string[], question: string) =>
    invoke<ChatAnswer>("chat_with_meetings", { meetingIds, question }),

  // AI-powered search 
  aiSearchMeetings: (query: string) =>
    invoke<SearchResult[]>("ai_search_meetings", { query }),

  // Generate agenda 
  generateAgenda: (meetingId: string) =>
    invoke<string>("generate_agenda", { meetingId }),

  // Meeting merge 
  mergeMeetings: (sourceId: string, targetId: string) =>
    invoke<void>("merge_meetings", { sourceId, targetId }),

  // Import transcripts 
  importTranscript: (meetingId: string, content: string, format: string) =>
    invoke<void>("import_transcript", { meetingId, content, format }),

  // Data retention 
  runRetentionPolicy: () => invoke<number>("run_retention_policy"),

  // Reorder folders (drag-and-drop)
  reorderFolders: (folderIds: string[], parentId: string | null = null) =>
    invoke<void>("reorder_folders", { folderIds, parentId }),

  // Batch re-transcribe existing recordings
  batchRetranscribe: (meetingIds: string[]) =>
    invoke<RetranscribeResult[]>("batch_retranscribe", { meetingIds }),

  // Database health check
  checkDatabaseHealth: () =>
    invoke<DatabaseHealth>("check_database_health"),

  // Attachments
  addAttachment: (meetingId: string, filePath: string) =>
    invoke<Attachment>("add_attachment", { meetingId, filePath }),
  /** Persist a screenshot pasted into the notes (raw PNG bytes as base64)
   *  as a regular attachment under attachments/<meeting_id>/ (plan v9 #13). */
  savePastedImage: (meetingId: string, base64Png: string) =>
    invoke<Attachment>("save_pasted_image", { meetingId, base64Png }),
  listAttachments: (meetingId: string) =>
    invoke<Attachment[]>("list_attachments", { meetingId }),
  deleteAttachment: (id: string) =>
    invoke<void>("delete_attachment", { id }),
  openAttachment: (id: string) =>
    invoke<void>("open_attachment", { id }),

  // Markdown export to filesystem
  saveMarkdownExport: (filename: string, content: string) =>
    invoke<string>("save_markdown_export", { filename, content }),

  // AI: generate structured meeting notes 
  generateMeetingNotes: (meetingId: string, userNotes: string, templateId?: string | null) =>
    invoke<import("./tiptap/generatedNotesToTiptap").GeneratedNotes>(
      "generate_meeting_notes", { meetingId, userNotes, templateId: templateId ?? null }
    ),

  // Speaker recognition
  unknownSpeakersForMeeting: (meetingId: string) =>
    invoke<UnknownSpeaker[]>("unknown_speakers_for_meeting", { meetingId }),
  identifySpeaker: (meetingId: string, speakerKey: string, name: string, startMs: number, endMs: number) =>
    invoke<void>("identify_speaker", { meetingId, speakerKey, name, startMs, endMs }),
  /** Re-cluster the speakers on a meeting's transcript using mel embeddings.
   *  Returns the number of distinct speakers detected. */
  reclusterSpeakers: (meetingId: string) =>
    invoke<number>("recluster_speakers", { meetingId }),
  /** Merge a duplicate detected speaker into another; returns segments changed. */
  mergeSpeakers: (meetingId: string, fromKey: string, intoKey: string) =>
    invoke<number>("merge_speakers", { meetingId, fromKey, intoKey }),
  /** Build an "About you" profile from recent meetings' AI notes. */
  generateUserContext: () => invoke<string>("generate_user_context"),
  /** Open action items from prior meetings sharing an attendee. */
  openLoopsForMeeting: (meetingId: string) =>
    invoke<ActionItem[]>("open_loops_for_meeting", { meetingId }),
  /** The previous meeting in this recurring series (matched by normalized title). */
  lastTimeInSeries: (meetingId: string) =>
    invoke<LastTimeCard | null>("last_time_in_series", { meetingId }),
  /** Export tasks to Apple Reminders ("Perchnote" list); returns count exported. */
  exportTasksToReminders: (
    items: Array<{
      task: string;
      body: string;
      deadline: string | null;
      note_id: string;
      source: string;
      index: number;
    }>,
  ) => invoke<number>("export_tasks_to_reminders", { items }),
  /** Pull completion state back from the Reminders "Perchnote" list. */
  pullReminderCompletions: () => invoke<number>("pull_reminder_completions"),
  /** Snooze a task until a date (null = unsnooze). Overlay-only. */
  setTaskSnooze: (noteId: string, source: string, index: number, snoozedUntil: string | null, task?: string) =>
    invoke<void>("set_task_snooze", { noteId, source, index, snoozedUntil, task }),
  /** Consciously drop a task in triage (overlay-only). */
  setTaskDropped: (noteId: string, source: string, index: number, dropped: boolean, task?: string) =>
    invoke<void>("set_task_dropped", { noteId, source, index, dropped, task }),
  getRecordingUrl: (meetingId: string) =>
    invoke<string>("get_recording_url", { meetingId }),
  /** Write a checksummed .perchnote archive (db + recordings + attachments) to the Desktop. */
  exportBackupArchive: () =>
    invoke<{ path: string; files: number; bytes: number }>("export_backup_archive"),
  /** Re-hash every file inside a .perchnote archive against its manifest. */
  verifyBackupArchive: (path: string) =>
    invoke<{ ok: boolean; checked: number; problems: string[] }>("verify_backup_archive", { path }),
  /** Nearest-meaning transcript segments; [] whenever semantic recall is off.
   *  start_ms is the matched segment's start (jump-to-moment), null when the
   *  vector no longer resolves to a transcript segment. */
  semanticSearch: (query: string, limit?: number) =>
    invoke<Array<{ meeting_id: string; snippet: string; distance: number; start_ms: number | null }>>(
      "semantic_search", { query, limit }
    ),
  /** Per-tracker monthly distinct-meeting mention counts (trailing 6 months). */
  getTopicTrends: () => invoke<TopicTrend[]>("get_topic_trends"),
  /** Cached monthly narrative, if ever generated (never generates). */
  getMonthlyNarrative: (month?: string) =>
    invoke<CachedInsight | null>("get_monthly_narrative", { month }),
  /** One provider call over the month's facts JSON; cached + returned. */
  generateMonthlyNarrative: (month?: string) =>
    invoke<CachedInsight>("generate_monthly_narrative", { month }),
  /** Cached quarter/year narrative ("2026-Q2" | "2026"), if ever generated. */
  getPeriodNarrative: (period: string) =>
    invoke<CachedInsight | null>("get_period_narrative", { period }),
  /** One provider call over the period's counts/hours/titles-only facts JSON; cached + returned. */
  generatePeriodNarrative: (period: string) =>
    invoke<CachedInsight>("generate_period_narrative", { period }),
  /** Deterministic brag-doc markdown (no AI) written to the Desktop; returns the path. */
  exportBragDoc: (period: string) =>
    invoke<string>("export_brag_doc", { period }),
  /** True when the selected AI provider is ready (key present / reachable). */
  checkAiConfigured: () => invoke<boolean>("check_ai_configured"),
  /** One round-trip for every list preview line (replaces per-meeting note fetches). */
  listNotePreviews: () =>
    invoke<Array<{ meeting_id: string; preview: string }>>("list_note_previews"),
  /** Permanently delete everything in the trash; returns how many went. */
  emptyTrash: () => invoke<number>("empty_trash"),
  /** Where the bytes actually are: db vs recordings vs attachments vs backups. */
  getStorageBreakdown: () => invoke<StorageBreakdown>("get_storage_breakdown"),
  /** What "keep audio for N days" would reclaim right now. */
  previewAudioRetention: (days: number) =>
    invoke<{ files: number; bytes: number }>("preview_audio_retention", { days }),
  /** Exempt one meeting's audio from the retention sweep. */
  setAudioKeep: (id: string, keep: boolean) =>
    invoke<void>("set_audio_keep", { id, keep }),
  /** Delete just the WAV — meeting, notes, and transcript stay. Returns bytes freed. */
  deleteMeetingAudio: (id: string) => invoke<number>("delete_meeting_audio", { id }),
  /** .perchnote archives found on Desktop/Documents/Downloads, newest first. */
  listBackupArchives: () =>
    invoke<Array<{ path: string; bytes: number; modified: string }>>("list_backup_archives"),
  /** Verify + stage an archive for restore; the swap happens on relaunch. */
  restoreBackupArchive: (path: string) =>
    invoke<number>("restore_backup_archive", { path }),
  /** Relaunch the app (used to complete a staged restore). */
  restartApp: () => invoke<void>("restart_app"),
  /** Post a local macOS notification. */
  notifyUser: (title: string, body: string) =>
    invoke<void>("notify_user", { title, body }),
  /** Flag the transcript moment at ms (applies now or when its segment lands). */
  highlightMoment: (meetingId: string, ms: number) =>
    invoke<boolean>("highlight_moment", { meetingId, ms }),
  /** Flip one transcript segment's highlight; returns the new state. */
  toggleSegmentHighlight: (meetingId: string, index: number) =>
    invoke<boolean>("toggle_segment_highlight", { meetingId, index }),
  /** Edit one transcript segment's text; FTS and embeddings re-sync. */
  updateSegmentText: (meetingId: string, index: number, text: string) =>
    invoke<boolean>("update_segment_text", { meetingId, index, text }),
  /** Import an audio file as a new meeting — converts, transcribes,
   *  detects speakers, runs the normal completion hooks. Returns the id. */
  importAudioFile: (path: string) => invoke<string>("import_audio_file", { path }),
  /** Mid-meeting recap of the transcript-so-far — transient, never stored. */
  catchMeUp: (meetingId: string) => invoke<string>("catch_me_up", { meetingId }),
  /** Find→replace across the whole transcript; returns segments touched. */
  replaceInTranscript: (meetingId: string, find: string, replace: string) =>
    invoke<number>("replace_in_transcript", { meetingId, find, replace }),
  /** Talk-balance stats persisted at recording stop (JSON or null). */
  getTalkStats: (meetingId: string) =>
    invoke<string | null>("get_talk_stats", { meetingId }),
  /** Manual update check against GitHub releases (user-initiated only). */
  checkForUpdate: () =>
    invoke<{ current: string; latest: string; url: string; update_available: boolean }>(
      "check_for_update"
    ),
  /** Download the ~1MB Silero VAD model that gates transcription chunks. */
  downloadVadModel: () => invoke<string>("download_vad_model"),
  vadModelReady: () => invoke<boolean>("vad_model_ready"),
  /** Mirror one meeting's notes as Markdown (no-op when the mirror is off).
   *  Never clobbers (plan v10 #9): if the file was edited outside the app,
   *  the user's copy stays and the new content lands in a `.conflict.md`
   *  beside it — `conflicted` reports which happened. */
  writeMdMirror: (meetingId: string, markdown: string) =>
    invoke<MirrorWriteResult>("write_md_mirror", { meetingId, markdown }),
  /**
   * Deep-link actions from the URL that LAUNCHED the app — those arrive
   * before any frontend listener mounts, so the runtime event is lost.
   * One-shot: the backend returns them once, empty thereafter.
   */
  takeLaunchDeepActions: () =>
    invoke<DeepActionWire[]>("take_launch_deep_actions"),
};

/** Returns true if the location string looks like a URL rather than a physical address. */
export function isLocationUrl(location: string): boolean {
  return /^https?:\/\/|^zoom\.us|^meet\.google\.com|^teams\.microsoft\.com/i.test(location.trim());
}

/** Opens a meeting location — as a URL if it looks like one, else in Apple Maps. */
export function openLocation(location: string): void {
  if (isLocationUrl(location)) {
    ipc.openUrl(location.trim());
  } else {
    ipc.openUrl(`https://maps.apple.com/?q=${encodeURIComponent(location)}`);
  }
}
