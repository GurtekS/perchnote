import { invoke } from "@tauri-apps/api/core";

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
}

export interface Transcript {
  id: string;
  meeting_id: string;
  segments: string;
  source: string;
  language: string;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  meeting_id: string | null;
  role: string;
  content: string;
  context_meeting_ids: string;
  created_at: string;
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

// --- IPC Functions ---

export const ipc = {
  // Meetings
  createMeeting: (title: string) => invoke<Meeting>("create_meeting", { title }),
  getMeeting: (id: string) => invoke<Meeting | null>("get_meeting", { id }),
  listMeetings: () => invoke<Meeting[]>("list_meetings"),
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
  listDeletedMeetings: () => invoke<Meeting[]>("list_deleted_meetings"),

  // Notes
  createNote: (meetingId: string, templateId?: string) =>
    invoke<Note>("create_note", { meetingId, templateId }),
  getNoteByMeeting: (meetingId: string) =>
    invoke<Note | null>("get_note_by_meeting", { meetingId }),
  updateNoteRawContent: (id: string, rawContent: string) =>
    invoke<void>("update_note_raw_content", { id, rawContent }),
  updateNoteGeneratedContent: (id: string, generatedContent: string) =>
    invoke<void>("update_note_generated_content", { id, generatedContent }),

  // Transcripts
  getTranscriptByMeeting: (meetingId: string) =>
    invoke<Transcript | null>("get_transcript_by_meeting", { meetingId }),
  // Re-diarize transcript with adaptive speaker model
  rediarizeTranscript: (meetingId: string) =>
    invoke<string>("rediarize_transcript", { meetingId }),
  deleteTranscriptSegment: (meetingId: string, segmentIndex: number) =>
    invoke<void>("delete_transcript_segment", { meetingId, segmentIndex }),

  // Recording controls
  startRecording: (meetingId: string, deviceName?: string | null) =>
    invoke<void>("start_recording", { meetingId, deviceName: deviceName ?? null }),
  stopRecording: () => invoke<string>("stop_recording"),
  pauseRecording: () => invoke<void>("pause_recording"),
  resumeRecording: () => invoke<void>("resume_recording"),
  isPaused: () => invoke<boolean>("is_paused"),

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

  // Storage / Backup
  getStorageStats: () => invoke<StorageStats>("get_storage_stats"),
  exportAllData: () => invoke<string>("export_all_data"),

  // App Paths & Models
  getAppPaths: () => invoke<AppPaths>("get_app_paths"),
  listWhisperModels: () => invoke<ModelInfo[]>("list_whisper_models"),
  isOllamaRunning: () => invoke<boolean>("is_ollama_running"),
  listOllamaModels: () => invoke<string[]>("list_ollama_models"),
  isAppleAiAvailable: () => invoke<boolean>("is_apple_ai_available"),
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

  // AI chat with multiple meetings 
  chatWithMeetings: (meetingIds: string[], question: string) =>
    invoke<string>("chat_with_meetings", { meetingIds, question }),

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
  generateMeetingNotes: (meetingId: string, userNotes: string) =>
    invoke<import("./tiptap/generatedNotesToTiptap").GeneratedNotes>(
      "generate_meeting_notes", { meetingId, userNotes }
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
  getRecordingUrl: (meetingId: string) =>
    invoke<string>("get_recording_url", { meetingId }),
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
